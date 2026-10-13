import sqlite3
import unittest

from repository import apply_sync_event, initialize_database


def completion_event(mutation_id="mutation-1", tenant_id="tenant-a", job_id="job-1", worker_id="worker-1", expected_revision=1):
    return {
        "mutation_id": mutation_id,
        "tenant_id": tenant_id,
        "job_id": job_id,
        "actor_user_id": worker_id,
        "event_type": "job.completed",
        "expected_revision": expected_revision,
        "occurred_at": "2026-10-13T07:30:00Z",
        "payload": {
            "notes": "Washrooms and reception completed.",
            "checklist": [{"label": "Washrooms cleaned", "done": True}],
            "client_signoff_name": "A. Client",
            "evidence": [],
        },
    }


class OfflineSyncTests(unittest.TestCase):
    def setUp(self):
        self.connection = sqlite3.connect(":memory:")
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA foreign_keys = ON")
        initialize_database(self.connection, seed_demo=False)
        self.connection.execute("INSERT INTO tenants (id, name) VALUES ('tenant-a', 'A Cleaning Co')")
        self.connection.execute("INSERT INTO tenants (id, name) VALUES ('tenant-b', 'B Cleaning Co')")
        self.connection.execute("INSERT INTO users (id, tenant_id, name, role) VALUES ('worker-1', 'tenant-a', 'Musa', 'worker')")
        self.connection.execute("INSERT INTO users (id, tenant_id, name, role) VALUES ('worker-2', 'tenant-a', 'Asha', 'worker')")
        self.connection.execute("""
            INSERT INTO jobs
                (id, tenant_id, client_name, site_name, service_type, scheduled_for,
                 assigned_worker_id, status, revision, checklist_json, created_at)
            VALUES
                ('job-1', 'tenant-a', 'Mwangaza Offices', 'Westlands', 'Office cleaning',
                 '2026-10-13', 'worker-1', 'assigned', 1, '[]', '2026-10-13T06:00:00Z')
        """)
        self.connection.commit()

    def tearDown(self):
        self.connection.close()

    def test_retried_event_is_acknowledged_once(self):
        first = apply_sync_event(self.connection, completion_event())
        retry = apply_sync_event(self.connection, completion_event())

        self.assertFalse(first["duplicate"])
        self.assertTrue(retry["duplicate"])
        self.assertEqual(
            self.connection.execute("SELECT COUNT(*) FROM completion_events").fetchone()[0], 1
        )

    def test_stale_completion_is_kept_and_flagged_for_review(self):
        self.connection.execute("UPDATE jobs SET revision = 2 WHERE id = 'job-1'")
        self.connection.commit()

        result = apply_sync_event(self.connection, completion_event(expected_revision=1))

        self.assertTrue(result["review_required"])
        job = self.connection.execute("SELECT status FROM jobs WHERE id = 'job-1'").fetchone()
        self.assertEqual(job["status"], "completed_pending_review")
        self.assertEqual(
            self.connection.execute("SELECT COUNT(*) FROM completion_events").fetchone()[0], 1
        )

    def test_rejects_cross_tenant_job_access(self):
        with self.assertRaisesRegex(ValueError, "job_not_found"):
            apply_sync_event(self.connection, completion_event(tenant_id="tenant-b"))

        self.assertEqual(
            self.connection.execute("SELECT COUNT(*) FROM completion_events").fetchone()[0], 0
        )

    def test_rejects_completion_from_unassigned_worker(self):
        with self.assertRaisesRegex(ValueError, "worker_not_assigned"):
            apply_sync_event(self.connection, completion_event(worker_id="worker-2"))

        self.assertEqual(
            self.connection.execute("SELECT COUNT(*) FROM completion_events").fetchone()[0], 0
        )


if __name__ == "__main__":
    unittest.main()
