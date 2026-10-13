"""SQLite persistence for the local, single-tenant product demo.

Production should replace this adapter with managed PostgreSQL, authorization,
and object storage. Keeping the SQL access behind these functions makes that
change explicit rather than leaking SQLite details into the browser workflow.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import date, datetime, timezone
from typing import Any


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def initialize_database(connection: sqlite3.Connection, seed_demo: bool = True) -> None:
    connection.executescript("""
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS tenants (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS users (
            id TEXT NOT NULL,
            tenant_id TEXT NOT NULL REFERENCES tenants(id),
            name TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'supervisor', 'worker')),
            PRIMARY KEY (id, tenant_id)
        );
        CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL REFERENCES tenants(id),
            client_name TEXT NOT NULL,
            site_name TEXT NOT NULL,
            service_type TEXT NOT NULL,
            scheduled_for TEXT NOT NULL,
            assigned_worker_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('assigned', 'in_progress', 'completed', 'completed_pending_review')),
            revision INTEGER NOT NULL DEFAULT 1,
            checklist_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE (tenant_id, id),
            FOREIGN KEY (assigned_worker_id, tenant_id) REFERENCES users(id, tenant_id)
        );
        CREATE INDEX IF NOT EXISTS jobs_tenant_schedule ON jobs(tenant_id, scheduled_for);
        CREATE TABLE IF NOT EXISTS completion_events (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL REFERENCES tenants(id),
            mutation_id TEXT NOT NULL,
            job_id TEXT NOT NULL,
            actor_user_id TEXT NOT NULL,
            expected_revision INTEGER NOT NULL,
            event_type TEXT NOT NULL CHECK (event_type = 'job.completed'),
            occurred_at TEXT NOT NULL,
            received_at TEXT NOT NULL,
            review_required INTEGER NOT NULL CHECK (review_required IN (0, 1)),
            payload_json TEXT NOT NULL,
            UNIQUE (tenant_id, mutation_id),
            FOREIGN KEY (job_id, tenant_id) REFERENCES jobs(id, tenant_id),
            FOREIGN KEY (actor_user_id, tenant_id) REFERENCES users(id, tenant_id)
        );
        CREATE INDEX IF NOT EXISTS completion_events_job ON completion_events(tenant_id, job_id, received_at);
        CREATE TABLE IF NOT EXISTS sync_receipts (
            tenant_id TEXT NOT NULL REFERENCES tenants(id),
            mutation_id TEXT NOT NULL,
            response_json TEXT NOT NULL,
            received_at TEXT NOT NULL,
            PRIMARY KEY (tenant_id, mutation_id)
        );
    """)
    if seed_demo:
        seed_demo_data(connection)
    connection.commit()


def seed_demo_data(connection: sqlite3.Connection) -> None:
    tenant_id = "demo-cleaning-co"
    existing = connection.execute("SELECT 1 FROM tenants WHERE id = ?", (tenant_id,)).fetchone()
    if existing:
        return

    connection.execute("INSERT INTO tenants (id, name) VALUES (?, ?)", (tenant_id, "KaziProof Demo"))
    connection.executemany(
        "INSERT INTO users (id, tenant_id, name, role) VALUES (?, ?, ?, ?)",
        [
            ("admin-wanjiku", tenant_id, "Wanjiku N.", "admin"),
            ("worker-musa", tenant_id, "Musa K.", "worker"),
            ("worker-asha", tenant_id, "Asha M.", "worker"),
        ],
    )
    checklist = [
        {"id": "reception", "label": "Reception and desks cleaned"},
        {"id": "washrooms", "label": "Washrooms cleaned and restocked"},
        {"id": "floors", "label": "Floors swept and mopped"},
        {"id": "waste", "label": "Waste collected"},
    ]
    connection.execute(
        """INSERT INTO jobs
            (id, tenant_id, client_name, site_name, service_type, scheduled_for,
             assigned_worker_id, status, revision, checklist_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'assigned', 1, ?, ?)""",
        (
            "job-1042", tenant_id, "Mwangaza Offices", "Westlands HQ",
            "Daily office cleaning", date.today().isoformat(), "worker-musa",
            json.dumps(checklist), utc_now(),
        ),
    )


def list_jobs(connection: sqlite3.Connection, tenant_id: str) -> list[dict[str, Any]]:
    rows = connection.execute(
        """SELECT j.*, u.name AS assigned_worker_name
           FROM jobs j JOIN users u
             ON u.id = j.assigned_worker_id AND u.tenant_id = j.tenant_id
           WHERE j.tenant_id = ?
           ORDER BY j.scheduled_for, j.created_at DESC""",
        (tenant_id,),
    ).fetchall()
    jobs: list[dict[str, Any]] = []
    for row in rows:
        job = dict(row)
        job["checklist"] = json.loads(job.pop("checklist_json"))
        events = connection.execute(
            """SELECT payload_json, occurred_at, received_at, review_required
               FROM completion_events WHERE tenant_id = ? AND job_id = ?
               ORDER BY received_at DESC LIMIT 1""",
            (tenant_id, job["id"]),
        ).fetchone()
        if events:
            job["completion"] = {
                "payload": json.loads(events["payload_json"]),
                "occurred_at": events["occurred_at"],
                "received_at": events["received_at"],
                "review_required": bool(events["review_required"]),
            }
        else:
            job["completion"] = None
        jobs.append(job)
    return jobs


def list_workers(connection: sqlite3.Connection, tenant_id: str) -> list[dict[str, str]]:
    return [dict(row) for row in connection.execute(
        "SELECT id, name, role FROM users WHERE tenant_id = ? AND role IN ('worker', 'supervisor') ORDER BY name",
        (tenant_id,),
    ).fetchall()]


def create_job(connection: sqlite3.Connection, tenant_id: str, data: dict[str, Any]) -> dict[str, Any]:
    required = ("client_name", "site_name", "service_type", "scheduled_for", "assigned_worker_id")
    for key in required:
        if not isinstance(data.get(key), str) or not data[key].strip():
            raise ValueError(f"{key}_required")
    try:
        normalized_date = date.fromisoformat(data["scheduled_for"].strip()[:10]).isoformat()
    except ValueError:
        raise ValueError("scheduled_for_invalid")

    worker = connection.execute(
        "SELECT id FROM users WHERE id = ? AND tenant_id = ? AND role IN ('worker', 'supervisor')",
        (data["assigned_worker_id"], tenant_id),
    ).fetchone()
    if not worker:
        raise ValueError("worker_not_found")

    service_type = data["service_type"].strip()[:100]
    checklist = [
        {"id": "site_checked", "label": "Work area checked before starting"},
        {"id": "task_done", "label": f"{service_type} completed"},
        {"id": "site_left_tidy", "label": "Work area left clean and safe"},
    ]
    job_id = f"job-{uuid.uuid4().hex[:8]}"
    connection.execute(
        """INSERT INTO jobs
            (id, tenant_id, client_name, site_name, service_type, scheduled_for,
             assigned_worker_id, status, revision, checklist_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'assigned', 1, ?, ?)""",
        (
            job_id, tenant_id, data["client_name"].strip()[:120],
            data["site_name"].strip()[:160], service_type,
            normalized_date, data["assigned_worker_id"],
            json.dumps(checklist), utc_now(),
        ),
    )
    connection.commit()
    return next(job for job in list_jobs(connection, tenant_id) if job["id"] == job_id)


def apply_sync_event(connection: sqlite3.Connection, event: dict[str, Any]) -> dict[str, Any]:
    """Apply one worker completion once, preserving stale work for review."""
    if not isinstance(event, dict):
        raise ValueError("event_invalid")
    for key in ("mutation_id", "tenant_id", "job_id", "actor_user_id", "occurred_at"):
        if not isinstance(event.get(key), str) or not event[key].strip():
            raise ValueError(f"{key}_required")
    if event.get("event_type") != "job.completed":
        raise ValueError("event_type_invalid")
    expected_revision = event.get("expected_revision")
    if not isinstance(expected_revision, int) or isinstance(expected_revision, bool) or expected_revision < 1:
        raise ValueError("expected_revision_invalid")
    payload = event.get("payload")
    if not isinstance(payload, dict):
        raise ValueError("payload_invalid")
    if len(json.dumps(payload, ensure_ascii=False).encode("utf-8")) > 1_000_000:
        raise ValueError("payload_too_large")

    tenant_id = event["tenant_id"]
    mutation_id = event["mutation_id"]
    try:
        connection.execute("BEGIN IMMEDIATE")
        receipt = connection.execute(
            "SELECT response_json FROM sync_receipts WHERE tenant_id = ? AND mutation_id = ?",
            (tenant_id, mutation_id),
        ).fetchone()
        if receipt:
            response = json.loads(receipt["response_json"])
            response["duplicate"] = True
            connection.commit()
            return response

        job = connection.execute(
            "SELECT * FROM jobs WHERE id = ? AND tenant_id = ?",
            (event["job_id"], tenant_id),
        ).fetchone()
        if not job:
            raise ValueError("job_not_found")
        if job["assigned_worker_id"] != event["actor_user_id"]:
            raise ValueError("worker_not_assigned")
        actor = connection.execute(
            "SELECT role FROM users WHERE id = ? AND tenant_id = ?",
            (event["actor_user_id"], tenant_id),
        ).fetchone()
        if not actor or actor["role"] not in ("worker", "supervisor"):
            raise ValueError("actor_not_allowed")

        review_required = (
            job["revision"] != expected_revision
            or job["status"] not in ("assigned", "in_progress")
        )
        status = "completed_pending_review" if review_required else "completed"
        received_at = utc_now()
        event_id = f"evt-{uuid.uuid4().hex}"
        connection.execute(
            """INSERT INTO completion_events
                (id, tenant_id, mutation_id, job_id, actor_user_id, expected_revision,
                 event_type, occurred_at, received_at, review_required, payload_json)
                VALUES (?, ?, ?, ?, ?, ?, 'job.completed', ?, ?, ?, ?)""",
            (
                event_id, tenant_id, mutation_id, event["job_id"], event["actor_user_id"],
                expected_revision, event["occurred_at"], received_at,
                int(review_required), json.dumps(payload, ensure_ascii=False),
            ),
        )
        connection.execute(
            "UPDATE jobs SET status = ?, revision = revision + 1 WHERE id = ? AND tenant_id = ?",
            (status, event["job_id"], tenant_id),
        )
        response = {
            "mutation_id": mutation_id,
            "event_id": event_id,
            "job_id": event["job_id"],
            "status": status,
            "review_required": review_required,
            "duplicate": False,
            "received_at": received_at,
        }
        connection.execute(
            "INSERT INTO sync_receipts (tenant_id, mutation_id, response_json, received_at) VALUES (?, ?, ?, ?)",
            (tenant_id, mutation_id, json.dumps(response), received_at),
        )
        connection.commit()
        return response
    except Exception:
        connection.rollback()
        raise
