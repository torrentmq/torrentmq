import { defineConfig } from "tsdown";

export default defineConfig({
  format: ["cjs", "esm"],
  entry: ["./src/index.ts"],
  dts: {
    tsconfig: "./tsconfig.json",
  },
  shims: true,
  deps: {
    neverBundle: true,
  },
  clean: true,
});
