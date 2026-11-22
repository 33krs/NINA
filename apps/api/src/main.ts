import process from 'node:process';
import console from 'node:console';
import { localStartupFailureMessage, startLocalApi } from './local-bootstrap';

void startLocalApi(process.env)
  .then(() =>
    console.log('Local HTTPS API listening on https://localhost:3001'),
  )
  .catch((error: unknown) => {
    console.error(localStartupFailureMessage(error));
    process.exitCode = 1;
  });
