#!/usr/bin/env bash

DENO_JOBS=8 deno test --allow-all --quiet --parallel test.ts
