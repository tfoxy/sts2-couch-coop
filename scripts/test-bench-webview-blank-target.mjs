#!/usr/bin/env node
import assert from "node:assert/strict";
import { selectBlankWebViewPageIndex } from "./lib/connect-bench-page.mjs";

const target = "http://127.0.0.1:5271/?stage=pixi";
assert.equal(selectBlankWebViewPageIndex(["about:blank"], target), 0);
assert.throws(() => selectBlankWebViewPageIndex([], target), /expected one blank WebView target/);
assert.throws(() => selectBlankWebViewPageIndex(["about:blank", "https://example.test/"], target),
  /expected one blank WebView target/);
assert.throws(() => selectBlankWebViewPageIndex(["https://example.test/"], target),
  /expected one blank WebView target/);
assert.throws(() => selectBlankWebViewPageIndex(["about:blank"], "http://example.test:5271/"),
  /explicit loopback HTTP page URL/);
console.log("blank WebView target selection passed");
