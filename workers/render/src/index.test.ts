import { test } from "node:test";
import assert from "node:assert/strict";
import * as pkg from "./index.ts";

test("пакет render грузится и видит packages/core", () => {
  assert.equal(pkg.PACKAGE_NAME, "@reels-factory/render");
  assert.equal(typeof pkg.BUILT_ON_CORE, "string");
});
