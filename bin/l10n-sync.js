#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// This script will sync the l10 branch with main branch
// Run with -y to automatically skip the prompts.

// @flow

const cp = require('child_process');
const readline = require('readline');
const { promisify } = require('util');
const { stripIndent, oneLine } = require('common-tags');

/*::
  type ExecFilePromiseSuccess = { stdout: string, stderr: string };
  type ExecFile = (
    command: string,
    args?: string[]
  ) => Promise<ExecFilePromiseSuccess>;
*/

const execFile /*: ExecFile */ = promisify(cp.execFile);

const DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});

let SKIP_PROMPTS = false;

/**
 * Logs the command to be executed first, and spawns a shell then executes the
 * command. Returns the stdout of the executed command.
 *
 * @param {string} executable
 * @param  {...string} args
 * @returns {Promise<string>} stdout of the executed command.
 * @throws Will throw an error if executed command fails.
 */
async function logAndExec(
  executable /*: string */,
  ...args /*: string[] */
) /*: Promise<string> */ {
  console.log('[exec]', executable, args.join(' '));
  const { stdout } = await execFile(executable, args);
  return stdout.toString();
}

/**
 * Logs the command to be executed first, and executes a series of shell commands
 * and pipes the stdout of them to the next one. In the end, returns the stdout
 * of the last piped command.
 *
 * @param  {...string[]} commands Array of commands
 * @returns {string} stdout of the last piped command.
 * @throws Will throw an error if one of the executed commands fails.
 */
function logAndPipeExec(...commands /*: string[][] */) /*: string */ {
  console.log('[exec]', commands.map(command => command.join(' ')).join(' | '));
  let prevOutput = '';
  for (const command of commands) {
    const [executable, ...args] = command;
    prevOutput = cp
      .execFileSync(executable, args, { input: prevOutput })
      .toString();
  }
  return prevOutput.toString();
}

/**
 * Pause with a message and wait for the enter as a confirmation.
 * The prompt will not be displayed if the `-y` argument is given to the script.
 * This is mainly used by the CircleCI automation.
 *
 * @param {string} message to be displayed before the prompt.
 * @returns {Promise<void>}
 */
async function pauseWithMessageIfNecessary(
  message /*: string */ = ''
) /*: Promise<void> */ {
  if (SKIP_PROMPTS) {
    return;
  }

  if (message.length > 0) {
    message += '\n';
  }
  message += 'Press ENTER when youʼre ready...';

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  await promisify(rl.question).call(rl, message);
  rl.close();
}

/**
 * Check if Git workspace is clean.
 *
 * @returns {Promise<void>}
 * @throws Will throw an error if workspace is not clean.
 */
async function checkIfWorkspaceClean() /*: Promise<void> */ {
  console.log('>>> Checking if the workspace is clean for the operations.');
  // git status --porcelain --ignore-submodules -unormal
  const status = await logAndExec(
    'git',
    'status',
    '--porcelain',
    '--ignore-submodules',
    '-unormal'
  );

  if (status.length) {
    throw new Error(
      'Your workspace is not clean. Please commit or stash your changes.'
    );
  }

  console.log('Workspace is clean.');
}

/**
 * Finds the Git upstream remote and returns it.
 *
 * @returns {Promise<string>} Name of the upstrem
 * @throws Will throw an error if it can't find an upstream remote.
 */
async function findUpstream() /*: Promise<string> */ {
  console.log('>>> Finding the upstream remote.');
  try {
    const gitRemoteResult = await logAndExec('git', 'remote', '-v');

    const remotes = gitRemoteResult.split('\n');
    const candidates = remotes.filter(
      line => /canova\/perf.html|firefox-devtools\/profiler/.test(line) // TODO: change 'canova' after
    );
    const upstream = candidates[0].split('\t')[0];

    return upstream;
  } catch (error) {
    throw new Error(stripIndent`
      Couldn't find the upstream remote. Is it well configured?
      We're looking for either devtools-html/perf.html or firefox-devtools/profiler.
    `);
  }
}

/**
 * Compares the `compareBranch` with `baseBranch` and checks the changed files.
 * Fails if the `compareBranch` has changes from the files that doesn't match
 * the `matchRegexp`.
 *
 * @param {string} upstream Name of the upstream remote.
 * @param {string} compareBranch Branch that we want to compare.
 * @param {string} baseBranch Branch that we want to take as base for comparison.
 * @param {RegExp} matchRegexp Regexp that will be used to match the files.
 * @throws Will throw an error if `compareBranch` has changes from the files
 * that doesn't match the `matchRegexp`.
 */
async function checkAllowedPaths(
  {
    upstream,
    compareBranch,
    baseBranch,
    matchRegexp,
  } /*:
  {|
    upstream: string,
    compareBranch: string,
    baseBranch: string ,
    matchRegexp: RegExp
  |}
  */
) {
  console.log(
    `>>> Checking if ${compareBranch} branch has changes from the files that are not allowed.`
  );
  // git log --no-merges baseBranch..compareBranch --pretty="format:" --name-only
  let changedFiles = await logAndExec(
    'git',
    'log',
    '--no-merges',
    `${upstream}/${baseBranch}..${upstream}/${compareBranch}`,
    '--pretty=format:',
    '--name-only'
  );
  changedFiles = changedFiles.split('\n');

  for (const file of changedFiles) {
    if (file.length > 0 && !matchRegexp.test(file)) {
      throw new Error(oneLine`
        ${compareBranch} branch includes changes from the files that are not
        allowed: ${file}
      `);
    }
  }
}

/**
 * This is a simple helper function that returns the friendly English versions
 * of how many times that occurs.
 *
 * It's a pretty simple hack and would be good to have a more sophisticated
 * (localized?) API function. But it's not really worth for a deployment only
 * script.
 *
 * @param {number} count
 * @returns {string}
 */
function fewTimes(count /*: number */) /*: string */ {
  switch (count) {
    case 1:
      return 'once';
    case 2:
      return 'twice';
    default:
      return `${count} times`;
  }
}

/**
 * Tries to sync the l10n branch and retries for 3 times if it fails to sync.
 *
 * @param {string} upstream
 * @returns {Promise<void>}
 * @throws Will throw an error if it fails to sync for more than 3 times.
 */
async function tryToSync(upstream /*: string */) /*: Promise<void> */ {
  console.log('>>> Syncing the l10n branch with main.');
  // RegExp for matching only the vendored locales.
  const vendoredLocalesPath = /^locales[\\/](?!en-US[\\/]).*$/g;
  // RegExp for matching anything but the vendored locales.
  const nonVendoredLocalesPath = /^(locales[\\/]en-US[\\/]|(?!locales[\\/])).*$/g;
  const totalTryCount = 3;
  let error /*: Error | null */ = null;
  let tryCount = 0;

  // Try to sync and retry for `totalTryCount` times if it fails.
  do {
    try {
      if (tryCount > 0) {
        console.warn(stripIndent`
        Syncing the l10n branch has failed.
        This may be due to a new commit during this operation. Trying again.
        Tried ${fewTimes(tryCount)} out of ${totalTryCount}.
      `);
      }

      console.log(`>>> Fetching upstream ${upstream}.`);
      await logAndExec('git', 'fetch', upstream);

      // First, check if the l10nn branch contains only changes in `locales` directory.
      await checkAllowedPaths({
        upstream,
        compareBranch: 'l10n',
        baseBranch: 'main',
        matchRegexp: vendoredLocalesPath,
      });

      // Second, check if the main branch contains changes except the translated locales.
      await checkAllowedPaths({
        upstream,
        compareBranch: 'main',
        baseBranch: 'l10n',
        matchRegexp: nonVendoredLocalesPath,
      });

      console.log('>>> Merging main to l10n.');
      await logAndExec('git', 'checkout', `${upstream}/l10n`);

      const currentDate = DATE_FORMAT.format(new Date());
      await logAndExec(
        'git',
        'merge',
        `${upstream}/main`,
        '-m',
        `🔃 Daily sync: main -> l10n (${currentDate})`
      );

      console.log(`>>> Pushing to ${upstream}'s l10n branch.`);
      await pauseWithMessageIfNecessary();
      await logAndExec('git', 'push', '--no-verify', upstream, 'HEAD:l10n');

      // Clear out the error after everything is done, in case this is a retry.
      error = null;
    } catch (e) {
      error = e;
    }
    tryCount++;
  } while (error !== null && tryCount < totalTryCount);

  if (error) {
    console.error(
      `Tried to sync the l10n branch ${fewTimes(totalTryCount)} but failed.`
    );
    throw error;
  }
}

/**
 * Main function to be executed in the global scope.
 *
 * @returns {Promise<void>}
 * @throws Will throw an error if any of the functions it calls throw.
 */
async function main() /*: Promise<void> */ {
  const args = process.argv.slice(2);

  if (args.length > 0 && args.includes('-y')) {
    SKIP_PROMPTS = true;
  }

  const upstream = await findUpstream();
  await checkIfWorkspaceClean();

  console.log(
    `This script will sync the l10n branch on the remote '${upstream}' with the main branch.`
  );
  await pauseWithMessageIfNecessary('Are you sure?');

  await tryToSync(upstream);

  console.log('>>> Going back to your previous banch.');
  await logAndExec('git', 'checkout', '-');

  console.log('>>> Done!');
}

main().catch((error /*: Error */) => {
  // Print the error to the console and exit if an error is caught.
  console.error(error);
  process.exit(1);
});
