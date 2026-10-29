// Registers `resolve-typescript.mjs` for the local demonstration's script only (issue #248).
import { register } from "node:module";

register("./resolve-typescript.mjs", import.meta.url);
