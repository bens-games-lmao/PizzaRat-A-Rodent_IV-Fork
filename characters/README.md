Rodent IV Character Profiles
============================

This directory is the **canonical storage** for Rodent IV character profiles.
Each file here is a JSON document that matches the `CharacterProfile` schema
defined in `schema.json` and produced by the engine's `DumpCharacterJson`
helper (used via the `characterjson` UCI command).

Conventions
-----------

- **One file per character**: `ID.json`, where `ID` is the character identifier.
- **Schema**: all JSON must validate against `schema.json`.
- **Source of truth**: these JSON files are considered authoritative; legacy
  personality `.txt` files in `personalities/` are treated as generated
  artifacts for old GUIs.

Workflow
--------

- Use the **character manager** service (under `tools/character-manager/`) or
  the web editor in `profiles/` to create, edit, copy and delete characters.
- Use the manager's export endpoint to regenerate `personalities/*.txt` and
  keep `personalities/characters.txt` in sync when you need legacy files.


