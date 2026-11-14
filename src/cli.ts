#!/usr/bin/env node
import { issue, jot, thoughts, work } from "./commands.ts";

const [, , command, ...rest] = process.argv;

if (command === "issue") {
  issue(rest[0], rest.slice(1));
} else if (command === "jot") {
  jot(rest);
} else if (command === "thoughts") {
  await thoughts(rest[0], rest.slice(1));
} else {
  // Everything else is a store-level command: init, serve, mcp, agent and so on.
  await work(command, rest);
}
