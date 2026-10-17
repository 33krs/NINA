'use strict';

const HELP = [
  'Usage: npm run training-accounts:postgres -- --run-isolated',
  '',
  'Build the API before running the isolated synthetic-account PostgreSQL proof.',
  'Use --help to display this message. Running the proof requires explicit authorization.',
  '',
].join('\n');
const USAGE_ERROR = `${HELP}`;
const GENERIC_FAILURE = 'TRAINING_POSTGRES_PROOF_FAILED\n';

function write(stream, value) {
  try {
    stream.write(value);
  } catch {
    // Output failures must not expose underlying diagnostics.
  }
}

function usage(args) {
  try {
    if (!Array.isArray(args)) return 'invalid';
    if (args.length === 0) return 'help';
    if (args.length !== 1 || typeof args[0] !== 'string') return 'invalid';
    if (args[0] === '--help') return 'help';
    if (args[0] === '--run-isolated') return 'run';
    return 'invalid';
  } catch {
    return 'invalid';
  }
}

function projectOutcome(value) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      return undefined;
    const projected = {
      passed: value.passed,
      proofSucceeded: value.proofSucceeded,
      cleanupConfirmed: value.cleanupConfirmed,
      recoveryRetained: value.recoveryRetained,
    };
    if (Object.values(projected).some((item) => typeof item !== 'boolean'))
      return undefined;
    return Object.freeze(projected);
  } catch {
    return undefined;
  }
}

function writeOutcome(status, outcome) {
  const lines = [`TRAINING_POSTGRES_PROOF_STATUS=${status}`];
  if (outcome) {
    lines.push(
      `passed=${outcome.passed}`,
      `proof_succeeded=${outcome.proofSucceeded}`,
      `cleanup_confirmed=${outcome.cleanupConfirmed}`,
      `recovery_retained=${outcome.recoveryRetained}`,
    );
  }
  write(process.stdout, `${lines.join('\n')}\n`);
}

async function main(args = process.argv.slice(2)) {
  const action = usage(args);
  if (action === 'help') {
    write(process.stdout, HELP);
    return 0;
  }
  if (action === 'invalid') {
    write(process.stderr, USAGE_ERROR);
    return 2;
  }

  let runProof;
  let cancellation;
  let proofSignal;
  let requestCancellation;
  try {
    const cancellationModule = require('./verify-odontogram-postgres.cjs');
    const runtimeModule = require('./training-accounts-postgres-runtime.cjs');
    const createCancellation = cancellationModule.createCancellation;
    runProof = runtimeModule.runTrainingAccountPostgresProof;
    if (
      typeof createCancellation !== 'function' ||
      typeof runProof !== 'function'
    )
      throw new Error('Invalid local proof modules');
    cancellation = createCancellation();
    proofSignal = cancellation?.signal;
    requestCancellation = cancellation?.request;
    if (
      cancellation === null ||
      typeof cancellation !== 'object' ||
      typeof requestCancellation !== 'function' ||
      proofSignal === null ||
      typeof proofSignal !== 'object' ||
      typeof proofSignal.aborted !== 'boolean' ||
      proofSignal.aborted ||
      cancellation.exitCode !== undefined
    ) {
      throw new Error('Invalid local cancellation helper');
    }
  } catch {
    write(process.stdout, GENERIC_FAILURE);
    return 1;
  }

  let signalRequested = false;
  let firstSignal;
  let signalFailure = false;
  let interruptInstalled = false;
  let terminateInstalled = false;
  let runtimeResult;
  let runtimeFailed = false;
  const handleSignal = (signal) => {
    if (signalRequested) return;
    signalRequested = true;
    firstSignal = signal;
    try {
      requestCancellation.call(cancellation, signal);
    } catch {
      signalFailure = true;
    }
  };
  const onInterrupt = () => handleSignal('SIGINT');
  const onTerminate = () => handleSignal('SIGTERM');
  try {
    process.on('SIGINT', onInterrupt);
    interruptInstalled = true;
    process.on('SIGTERM', onTerminate);
    terminateInstalled = true;
    runtimeResult = await runProof({ signal: proofSignal });
  } catch {
    runtimeFailed = true;
  } finally {
    if (interruptInstalled) process.removeListener('SIGINT', onInterrupt);
    if (terminateInstalled) process.removeListener('SIGTERM', onTerminate);
  }

  if (runtimeFailed || signalFailure) {
    let cancelled = false;
    let cancellationCode;
    try {
      cancellationCode = cancellation.exitCode;
      cancelled =
        signalRequested &&
        cancellationCode === (firstSignal === 'SIGINT' ? 130 : 143);
    } catch {
      cancelled = false;
    }
    if (cancelled) {
      writeOutcome('cancelled');
      return cancellationCode;
    }
    write(process.stdout, GENERIC_FAILURE);
    return 1;
  }

  let cancellationCode;
  try {
    cancellationCode = cancellation.exitCode;
  } catch {
    write(process.stdout, GENERIC_FAILURE);
    return 1;
  }
  const outcome = projectOutcome(runtimeResult);
  if (
    signalRequested &&
    cancellationCode === (firstSignal === 'SIGINT' ? 130 : 143)
  ) {
    writeOutcome('cancelled', outcome);
    return cancellationCode;
  }
  if (cancellationCode !== undefined || signalRequested) {
    write(process.stdout, GENERIC_FAILURE);
    return 1;
  }
  if (!outcome) {
    write(process.stdout, GENERIC_FAILURE);
    return 1;
  }

  const passed =
    outcome.passed === true &&
    outcome.proofSucceeded === true &&
    outcome.cleanupConfirmed === true &&
    outcome.recoveryRetained === false;
  writeOutcome(passed ? 'passed' : 'failed', outcome);
  return passed ? 0 : 1;
}

if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      write(process.stdout, GENERIC_FAILURE);
      process.exitCode = 1;
    },
  );
}

module.exports = { main };
