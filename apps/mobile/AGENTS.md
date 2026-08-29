# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v54.0.0/ before writing any code.

Downgraded from SDK 57 to 54 on 2026-08-26: the Expo Go app published on the App/Play Store
hadn't caught up to SDK 57 yet at the time (a common lag after a new SDK release), which
blocked testing on a physical phone via Expo Go without a custom dev build. If Expo Go (or
your build pipeline) later supports a newer SDK, re-run `npx expo install expo@latest && npx
expo install --fix` and update this file's version again — don't hand-edit individual package
versions.
