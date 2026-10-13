# iOS loading indicator PR preview

These images are review attachments on the `preview/ios-loading-layout` branch. Do not merge this branch into the product branch.

- Code revision: `4b074db94` (`fix/ios-loading-layout`).
- `after.png`: actual iPhone 16e simulator screenshot, iOS 26.2, default text size and light appearance, captured from the isolated PR build with pinned dependencies.
- `comparison.png`: matched crops of the initial reproduction and the fixed UI. The reproduction came from the original development checkout; its unrelated row-spacing change has no visible effect on this empty conversation.
- All data is synthetic and local; no account or remote host was connected.

Reproduce with a Debug build installed in a booted simulator:

```sh
xcrun simctl launch --terminate-running-process booted ai.wuu.native \
  --native-ui-fixture --native-composer-fixture \
  --native-empty-fixture --native-refresh-fixture
```
