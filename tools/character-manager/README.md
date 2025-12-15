Rodent IV Character Manager
===========================

This directory contains a small companion service that turns the Rodent IV
`characters/` JSON profiles into a canonical, API-driven workflow.

What this provides
------------------

- **HTTP API** under `/api/characters`:
  - `GET /api/characters` – list all characters from `characters/*.json`
  - `GET /api/characters/:id` – fetch a single character profile
  - `POST /api/characters` – create a new character (from body or a default template)
  - `PUT /api/characters/:id` – update an existing character
  - `DELETE /api/characters/:id` – delete a character
  - `POST /api/characters/:id/copy` – duplicate a character with a new id
  - `POST /api/characters/:id/export-txt` – generate/update a legacy
    `personalities/<id>.txt` file and keep `personalities/characters.txt` in sync
- **Static web UI** served from `profiles/` at the root URL so you can open
  `http://localhost:4000/` and use the editor as the canonical character surface.

Running the service
-------------------

From this directory:

1. Install dependencies:

   - `npm install`

2. Start the server:

   - `node server.js`
   - Or `npm start`

3. Open the web editor:

   - Visit `http://localhost:4000/` in your browser.

Migrating existing personalities
--------------------------------

To import existing `personalities/*.txt` into canonical JSON profiles:

1. Build or use a Rodent executable in the repo root (for example
   `rodent-iv-x64.exe` on Windows or `./rodentiii` on Unix).
2. From this directory, run:

   - `node migrate.js`
   - Or `npm run migrate`

The script will:

- Use `personalities/characters.txt` aliases (if present) to create
  `characters/<Alias>.json`.
- Create additional JSON profiles for any remaining `personalities/*.txt`
  not covered by aliases.
- For each personality, it:
  - Loads the personality via the engine.
  - Calls the `characterjson` UCI command.
  - Normalises and writes the JSON into `characters/`.


