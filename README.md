# KaziProof local demo

KaziProof is an offline-first field-work prototype for a Kenyan cleaning/facilities team. The simple K monogram and teal palette identify the product. The demo uses fictional KaziProof Demo tenant data and covers job dispatch, a worker checklist, compressed photo evidence, client sign-off, and queued completion sync.

## Run locally

1. Install Python 3.9 or newer. There are no third-party packages to install.
2. From this folder, run `python server.py`.
3. Open [http://127.0.0.1:4173](http://127.0.0.1:4173).

## Demo the offline flow

1. In **Office**, create and assign a fictional job, or use the seeded Mwangaza Offices job. It starts as assigned on a fresh database.
2. Open **Worker app** and choose the assigned worker.
3. Turn on **Simulate offline**. Open the visit, complete the checklist, draw a signature and enter the client's name. Photos are optional.
4. Save the visit. The app stores a pending event in this browser's IndexedDB and marks the job as queued.
5. Turn off **Simulate offline**. The event syncs to the local server. Return to **Office** to see its status and evidence.
6. To try actual browser offline mode, first load the app once so the service worker caches the shell; then disconnect the browser/device network. Use **Sync** after reconnecting.

Use only fictional/demo information. This server binds to localhost and has no login, production-grade authorization, or deployment hardening.

To restore the seeded job, stop the server, remove `data/demo.sqlite3`, and restart `python server.py`. The server recreates the sample database; reload the page while connected so its IndexedDB cache refreshes.

## Checks

```powershell
python -m unittest discover -s tests -v
python -m py_compile server.py repository.py domain.py
node --check app/app.js
```

## Prototype boundaries

- Data is stored locally in `data/demo.sqlite3`; reset the demo by stopping the server and deleting that file.
- Worker jobs and the outbox are stored in browser IndexedDB. Browser storage can be cleared/evicted; do not rely on this demo for actual work.
- The SQLite API and seeded company are a development harness, not the production multi-tenant service. Production needs managed PostgreSQL, real authentication and server-side authorization, object storage, backups, retention controls, and a privacy/security review.
- Invoice arithmetic is implemented and tested as pre-tax invoice-ready arithmetic, but no invoice/report UI is included in this slice. It is not a tax invoice.
- Recurrence, client report links, client approval/dispute, AI, M-Pesa and eTIMS are not implemented.
