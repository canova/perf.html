/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getProfile } from 'firefox-profiler/selectors/profile';
import { getSelectedThreadIndexes } from 'firefox-profiler/selectors/url-state';
import { getThreadSelectors } from 'firefox-profiler/selectors/per-thread';
import { parseFunctionHandle } from './function-map';
import type { ThreadMap } from './thread-map';
import {
  getStackLineInfo,
  getLineTimings,
} from 'firefox-profiler/profile-logic/line-timings';
import {
  getStackAddressInfo,
  getAddressTimings,
} from 'firefox-profiler/profile-logic/address-timings';
import { fetchAssembly } from 'firefox-profiler/utils/fetch-assembly';
import { fetchSource } from 'firefox-profiler/utils/fetch-source';
import type { ExternalCommunicationDelegate } from 'firefox-profiler/utils/query-api';
import type { AddressProof } from 'firefox-profiler/types';
import type {
  FunctionAnnotateResult,
  AnnotateMode,
  FunctionSourceAnnotation,
  FunctionAsmAnnotation,
} from './types';
import type { Store } from '../types/store';

class NodeExternalCommunicationDelegate implements ExternalCommunicationDelegate {
  async fetchUrlResponse(url: string, postData?: string): Promise<Response> {
    const init: RequestInit =
      postData !== undefined ? { method: 'POST', body: postData } : {};
    return fetch(url, init);
  }

  async queryBrowserSymbolicationApi(
    _path: string,
    _requestJson: string
  ): Promise<string> {
    throw new Error('No browser connection available in profiler-cli');
  }

  async fetchJSSourceFromBrowser(_source: string): Promise<string> {
    throw new Error('No browser connection available in profiler-cli');
  }
}

const nodeDelegate = new NodeExternalCommunicationDelegate();

export async function functionAnnotate(
  store: Store,
  threadMap: ThreadMap,
  archiveCache: Map<string, Promise<Uint8Array>>,
  functionHandle: string,
  mode: AnnotateMode,
  symbolServerUrl: string,
  contextOption: string
): Promise<FunctionAnnotateResult> {
  const state = store.getState();
  const profile = getProfile(state);
  const { funcTable, stringArray, resourceTable } = profile.shared;

  const funcIndex = parseFunctionHandle(functionHandle, funcTable.length);
  const funcName = stringArray[funcTable.name[funcIndex]];
  const warnings: string[] = [];

  // Resolve library name for fullName
  const resourceIndex = funcTable.resource[funcIndex];
  let libraryName: string | undefined;
  if (resourceIndex !== -1) {
    const libIndex = resourceTable.lib[resourceIndex];
    if (
      libIndex !== null &&
      libIndex !== undefined &&
      libIndex >= 0 &&
      profile.libs
    ) {
      libraryName = profile.libs[libIndex].name;
    }
  }
  const fullName = libraryName ? `${libraryName}!${funcName}` : funcName;

  // Get selected thread + derived thread data (derived Thread has correct types for utilities)
  const threadIndexes = getSelectedThreadIndexes(state);
  const threadSelectors = getThreadSelectors(threadIndexes);
  const thread = threadSelectors.getFilteredThread(state);
  const {
    stackTable,
    frameTable,
    funcTable: threadFuncTable,
    nativeSymbols: threadNativeSymbols,
  } = thread;
  const samples = thread.samples;

  const friendlyThreadName = threadSelectors.getFriendlyThreadName(state);
  const threadHandle = threadMap.handleForThreadIndexes(threadIndexes);

  // Single pass over frameTable to collect everything keyed on funcIndex:
  // - frameInFunc: which frames belong to funcIndex
  // - nativeSymbolsForFunc: distinct native symbols for this func
  // - addressProof: first usable {debugName, breakpadId, address} for /source/v1
  const frameInFunc = new Uint8Array(frameTable.func.length);
  const nativeSymbolsForFunc = new Set<number>();
  let addressProof: AddressProof | null = null;
  for (let fi = 0; fi < frameTable.func.length; fi++) {
    if (frameTable.func[fi] !== funcIndex) {
      continue;
    }
    frameInFunc[fi] = 1;
    const ns = frameTable.nativeSymbol[fi];
    if (ns !== null) {
      nativeSymbolsForFunc.add(ns);
      if (addressProof === null) {
        const libIndex = threadNativeSymbols.libIndex[ns];
        const lib = profile.libs[libIndex];
        if (lib.debugName && lib.breakpadId) {
          addressProof = {
            debugName: lib.debugName,
            breakpadId: lib.breakpadId,
            address: threadNativeSymbols.address[ns],
          };
        }
      }
    }
  }
  // Memoize bottom-up: does this stack contain any frame for funcIndex?
  // stackTable entries are in topological order (prefix always has lower index).
  const stackContainsFunc = new Int8Array(stackTable.length);
  for (let si = 0; si < stackTable.length; si++) {
    const frame = stackTable.frame[si];
    if (frameInFunc[frame]) {
      stackContainsFunc[si] = 1;
    } else {
      const prefix = stackTable.prefix[si];
      stackContainsFunc[si] = prefix !== null ? stackContainsFunc[prefix] : -1;
    }
  }

  let totalSelfSamples = 0;
  let totalTotalSamples = 0;
  for (let si = 0; si < samples.length; si++) {
    const stackIndex = samples.stack[si];
    if (stackIndex === null) {
      continue;
    }
    const weight = samples.weight ? samples.weight[si] : 1;
    if (stackContainsFunc[stackIndex] === 1) {
      totalTotalSamples += weight;
    }
    if (frameInFunc[stackTable.frame[stackIndex]]) {
      totalSelfSamples += weight;
    }
  }

  // Source annotation
  let srcAnnotation: FunctionSourceAnnotation | null = null;
  if (mode === 'src' || mode === 'all') {
    const sourceIndex = funcTable.source[funcIndex];
    if (sourceIndex !== null) {
      const filenameStrIndex = thread.sources.filename[sourceIndex];
      const filename = thread.stringTable.getString(filenameStrIndex);
      const sourceUuid = thread.sources.id[sourceIndex];

      // getStackLineInfo finds all frames belonging to this source file and
      // computes per-line hit sets. getLineTimings aggregates into self/total maps.
      const stackLineInfo = getStackLineInfo(
        stackTable,
        frameTable,
        threadFuncTable,
        sourceIndex
      );
      const { totalLineHits, selfLineHits } = getLineTimings(
        stackLineInfo,
        samples
      );

      // Count samples with/without line number information
      let samplesWithFunction = 0;
      let samplesWithLineInfo = 0;
      for (let si = 0; si < samples.length; si++) {
        const stackIndex = samples.stack[si];
        if (stackIndex === null) {
          continue;
        }
        const lineSetIndex = stackLineInfo.stackIndexToLineSetIndex[stackIndex];
        if (lineSetIndex === -1) {
          continue;
        }
        const weight = samples.weight ? samples.weight[si] : 1;
        samplesWithFunction += weight;
        if (stackLineInfo.lineSetTable.self[lineSetIndex] !== -1) {
          samplesWithLineInfo += weight;
        }
      }

      // addressProof is built in the single frameTable pass above; it's used
      // by fetchSource to query /source/v1 on local symbol servers.

      // Fetch source using the same path as the profiler UI:
      // tries /source/v1 on local symbol server, CORS download for Mercurial/crates.io, etc.
      let fileLines: string[] | null = null;
      let totalFileLines: number | null = null;
      const fetchResult = await fetchSource(
        filename,
        sourceUuid,
        symbolServerUrl,
        addressProof,
        archiveCache,
        nodeDelegate
      );
      if (fetchResult.type === 'SUCCESS') {
        fileLines = fetchResult.source.split('\n');
        totalFileLines = fileLines.length;
      } else {
        const errorMessages = fetchResult.errors
          .map((e) => JSON.stringify(e))
          .join('; ');
        warnings.push(
          `Could not fetch source for ${filename}: ${errorMessages}`
        );
      }

      // Determine which lines to show based on the context option
      const annotatedLineNums = new Set([
        ...totalLineHits.keys(),
        ...selfLineHits.keys(),
      ]);
      let linesToShow: Set<number>;
      let contextMode: string;

      if (contextOption === 'file') {
        // Show the whole file
        linesToShow = new Set<number>();
        const last = totalFileLines ?? Math.max(...annotatedLineNums);
        for (let ln = 1; ln <= last; ln++) {
          linesToShow.add(ln);
        }
        contextMode = 'full file';
      } else {
        // Treat as a number of context lines (default: 2)
        const parsed = parseInt(contextOption, 10);
        const CONTEXT = Math.max(0, isNaN(parsed) ? 2 : parsed);
        linesToShow = new Set<number>();
        for (const ln of annotatedLineNums) {
          for (
            let ctx = Math.max(1, ln - CONTEXT);
            ctx <= ln + CONTEXT;
            ctx++
          ) {
            linesToShow.add(ctx);
          }
        }
        contextMode =
          CONTEXT === 0 ? 'annotated lines only' : `±${CONTEXT} lines context`;
      }

      const sortedLines = Array.from(linesToShow).sort((a, b) => a - b);
      srcAnnotation = {
        filename,
        totalFileLines,
        samplesWithFunction,
        samplesWithLineInfo,
        contextMode,
        lines: sortedLines.map((ln) => ({
          lineNumber: ln,
          selfSamples: selfLineHits.get(ln) ?? 0,
          totalSamples: totalLineHits.get(ln) ?? 0,
          sourceText: fileLines !== null ? (fileLines[ln - 1] ?? null) : null,
        })),
      };
    } else if (mode === 'src') {
      warnings.push(
        `Function ${functionHandle} has no source index. Use --mode asm for assembly view.`
      );
    }
  }

  // Assembly annotation
  const asmAnnotations: FunctionAsmAnnotation[] = [];
  if (mode === 'asm' || mode === 'all') {
    if (nativeSymbolsForFunc.size === 0) {
      warnings.push(
        `Function ${functionHandle} has no native symbols — may be JS-only or not symbolicated.`
      );
    }

    const nativeSymbolCount = nativeSymbolsForFunc.size;

    // Fan out fetchAssembly in parallel — each native symbol is an
    // independent symbol-server request.
    const results = await Promise.all(
      Array.from(nativeSymbolsForFunc).map(async (nsIndex) => {
        const symbolName = thread.stringTable.getString(
          threadNativeSymbols.name[nsIndex]
        );
        const symbolAddress = threadNativeSymbols.address[nsIndex];
        const functionSize = threadNativeSymbols.functionSize[nsIndex] ?? null;
        const libIndex = threadNativeSymbols.libIndex[nsIndex];
        const lib = profile.libs[libIndex];

        const stackAddressInfo = getStackAddressInfo(
          stackTable,
          frameTable,
          threadFuncTable,
          nsIndex
        );
        const { totalAddressHits, selfAddressHits } = getAddressTimings(
          stackAddressInfo,
          samples
        );

        const nativeSymbolInfo = {
          name: symbolName,
          address: symbolAddress,
          functionSize: functionSize ?? 0,
          functionSizeIsKnown: functionSize !== null,
          libIndex,
        };

        let fetchError: string | null = null;
        let instructions: FunctionAsmAnnotation['instructions'] = [];
        const localWarnings: string[] = [];

        try {
          const fetchResult = await fetchAssembly(
            nativeSymbolInfo,
            lib,
            symbolServerUrl,
            nodeDelegate
          );
          if (fetchResult.type === 'SUCCESS') {
            instructions = fetchResult.instructions.map((instr) => ({
              address: instr.address,
              selfSamples: selfAddressHits.get(instr.address) ?? 0,
              totalSamples: totalAddressHits.get(instr.address) ?? 0,
              decodedString: instr.decodedString,
            }));
          } else {
            fetchError = fetchResult.errors
              .map((e) => JSON.stringify(e))
              .join('; ');
            localWarnings.push(
              `Assembly fetch failed for ${symbolName}: ${fetchError}`
            );
          }
        } catch (e) {
          fetchError = e instanceof Error ? e.message : String(e);
          localWarnings.push(
            `Assembly fetch threw for ${symbolName}: ${fetchError}`
          );
        }

        return {
          symbolName,
          symbolAddress,
          functionSize,
          fetchError,
          instructions,
          localWarnings,
        };
      })
    );

    results.forEach((r, i) => {
      warnings.push(...r.localWarnings);
      asmAnnotations.push({
        compilationIndex: i + 1,
        symbolName: r.symbolName,
        symbolAddress: r.symbolAddress,
        functionSize: r.functionSize,
        nativeSymbolCount,
        fetchError: r.fetchError,
        instructions: r.instructions,
      });
    });
  }

  return {
    type: 'function-annotate',
    functionHandle,
    funcIndex,
    name: funcName,
    fullName,
    threadHandle,
    friendlyThreadName,
    totalSelfSamples,
    totalTotalSamples,
    mode,
    srcAnnotation,
    asmAnnotations,
    warnings,
  };
}
