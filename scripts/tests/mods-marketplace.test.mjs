// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("../../src/zen/common/sys/ZenActorsManager.sys.mjs", import.meta.url),
  "utf8",
)
  .replace(/^import .*ActorManagerParent.*;$/m, "")
  .replace("export let gZenActorsManager", "let gZenActorsManager");

for (const configuredMatches of [
  "http://localhost/*",
  "https://zen-browser.app/*",
]) {
  test(`Mods actor includes the official marketplace with ${configuredMatches}`, () => {
    let actors;
    vm.runInNewContext(`${source}\ngZenActorsManager.init();`, {
      Services: {
        appinfo: { inSafeMode: false },
        prefs: { getStringPref: () => configuredMatches },
      },
      ActorManagerParent: {
        addJSProcessActors() {},
        addJSWindowActors(value) {
          actors = value;
        },
      },
    });
    assert.ok(
      actors.ZenModsMarketplace.matches.includes("https://zen-browser.app/*"),
    );
    assert.ok(actors.ZenModsMarketplace.matches.includes("about:preferences"));
    assert.ok(actors.ZenModsMarketplace.matches.includes(configuredMatches));
  });
}
