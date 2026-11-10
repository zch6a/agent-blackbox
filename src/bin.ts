#!/usr/bin/env node
import { main } from './cli.ts';

process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0); // `blackbox list | head` closed the pipe
});

main(process.argv.slice(2)).then(
  (code) => {
    // -1 means a long-running command (the UI server) owns the process lifetime.
    if (code >= 0) process.exitCode = code;
  },
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
