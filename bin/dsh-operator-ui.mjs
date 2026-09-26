#!/usr/bin/env node
// dsh-operator-ui — the published entry point.
//
// This file is deliberately three lines of substance. It exists so the package
// has ONE `bin` target whose whole job is to hand argv to lib/cli.js and turn the
// returned code into a process exit code. Everything worth testing lives in
// lib/cli.js, where a test can call it directly without spawning a process —
// which is why the installer's transactional path is provable rather than merely
// described.
//
// The exit ladder (see lib/cli.js) is the contract a caller branches on:
//   0 ok | 1 unverified | 2 blocked, nothing written | 3 failed, rolled back | 4 usage

import { main } from '../lib/cli.js';

process.exitCode = await main(process.argv.slice(2));
