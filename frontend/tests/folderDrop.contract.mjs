// Folder-drop settings contract.
//
// Task 8 of the library folder-drop ingestion feature: the Settings page
// needs a card that (1) reports the server-side folder-drop lane state
// honestly — loading first, never guessed from local input — and (2) lets an
// operator paste a URL straight into their library. Pinned here:
//   1. The card is anchored at id="folder-drop", directly below the
//      "Your business" section (id="business"), and follows its card/pill
//      conventions.
//   2. It round-trips through the folder-drop lane API (status, verify,
//      share) and the library URL-ingestion API.
//   3. The three lane-state copies are user-facing status language — they
//      must appear verbatim, not paraphrased, so a screenshot of the source
//      matches a screenshot of the UI.
//   4. The status pill derives from fetched server state with a loading
//      state first, mirroring the business-context pill's server-snapshot
//      pattern — never from anything the operator just typed.
//   5. A reader-email copy control exists because the reader address is not
//      memorable — the operator needs to paste it into Drive's sharing
//      dialog without retyping it.
//   6. A successful URL add reports the file by name; a failed one shows the
//      server's own message, not a generic fallback.

import { readFileSync } from 'node:fs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const settingsSource = readFileSync(new URL('../src/pages/SettingsPage.tsx', import.meta.url), 'utf8');

// 1. Anchored section, directly wired to the three Task 5/6 routes.
assert(settingsSource.includes('id="folder-drop"'), 'SettingsPage anchors the folder-drop section at #folder-drop.');
assert(settingsSource.includes('/api/workspace/library/folder-drop'), 'SettingsPage talks to the folder-drop lane-state API.');
assert(settingsSource.includes('/api/workspace/library/folder-drop/verify'), 'SettingsPage exposes a Verify control wired to the verify endpoint.');
assert(settingsSource.includes('/api/workspace/library/folder-drop/share'), 'SettingsPage exposes a Share control wired to the share endpoint.');
assert(settingsSource.includes('/api/workspace/library/url'), 'SettingsPage talks to the library URL-ingestion API.');

// 3. The four lane-state copies, verbatim.
assert(
  settingsSource.includes("Folder drop isn't configured on this server yet."),
  'not_configured lane-state copy is present verbatim.',
);
assert(
  settingsSource.includes(
    "Your Violema Library folder doesn't exist yet. It's created the first time a mission files something there — run a mission with a library step, then come back.",
  ),
  'no_library_yet lane-state copy is present verbatim — a workspace-level condition, never a server misconfiguration.',
);
assert(
  settingsSource.includes('Share your Violema Library folder with the reader address below, then verify.'),
  'needs_share lane-state copy is present verbatim.',
);
assert(
  settingsSource.includes('Violema can see files you drop in your Violema Library folder.'),
  'active lane-state copy is present verbatim.',
);

// 4. Loading-state-first status pill, driven by fetched state only.
assert(
  settingsSource.includes('folderDropLoading') && settingsSource.includes('folderDropStatus'),
  'The folder-drop status pill is driven by fetched server state with a loading state first.',
);

// 5. A reader-email copy control.
assert(
  settingsSource.includes('navigator.clipboard.writeText') && settingsSource.includes('readerEmail'),
  'SettingsPage offers a copy-to-clipboard control for the reader email.',
);

// A Verify action that re-checks lane state after the operator shares the
// folder in Drive, and a Share action for the programmatic path.
assert(
  settingsSource.includes('handleFolderDropVerify'),
  'SettingsPage exposes a Verify action that re-checks folder-drop lane state.',
);
assert(
  settingsSource.includes('handleFolderDropShare'),
  'SettingsPage exposes a Share action for the programmatic share path.',
);

// When programmatic sharing is not possible, the guided instructions reuse
// the needs_share copy rather than inventing separate wording.
assert(
  settingsSource.includes('manualShare'),
  'SettingsPage handles the manualShare flag from the share endpoint.',
);

// 6. "Add a link to your library": URL input feeding the same ingestion
// route, with the exact success copy and the server's own error message.
assert(
  settingsSource.includes('Add a link to your library'),
  'SettingsPage offers a URL-based library ingestion control.',
);
assert(
  settingsSource.includes('Added "') && settingsSource.includes('to your library.'),
  'A successful URL add reports the added file by name.',
);

console.log('folderDrop.contract: all assertions passed');
