#!/usr/bin/env node
import { runMain } from "citty";
import { buildMain } from "../src/cli.mjs";

runMain(await buildMain());
