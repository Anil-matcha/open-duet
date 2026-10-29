"""Real PostgreSQL upgrade/downgrade with retained routine history."""
import os
import subprocess
import sys

import pytest
from sqlalchemy import create_engine, inspect, text
from app.core.config import settings
from tests.db.test_schema_equivalence import postgres_databases  # noqa: F401
from tests.db.sqlite_helpers import BACKEND_DIR

pytestmark = pytest.mark.skipif(settings.DATABASE_KIND != "postgres", reason="requires PostgreSQL")


def test_quiet_postgres_roundtrip_preserves_rows(postgres_databases):
    url = postgres_databases["alembic"]
    environment = {**os.environ, "DATABASE_BACKEND": "postgres", "POSTGRES_DB": url.database}
    def migrate(*args):
        result = subprocess.run([sys.executable, "-m", "alembic", *args], cwd=BACKEND_DIR,
            env=environment, capture_output=True, text=True, timeout=120)
        assert result.returncode == 0, result.stderr
    migrate("upgrade", "e8a3c7b1d902")
    engine = create_engine(url)
    try:
        with engine.begin() as db:
            routine_id = db.scalar(text("INSERT INTO routine(owner_id,agent_id,name,prompt,schedule_kind,schedule_spec) VALUES('test',1,'Check','Check','manual','{}') RETURNING id"))
            db.execute(text("INSERT INTO routine_run(routine_id,trigger,state,result) VALUES(:id,'schedule','completed','Retained report')"), {"id": routine_id})
        migrate("upgrade", "head")
        with engine.connect() as db:
            assert db.scalar(text("SELECT quiet_reporting FROM routine")) is False
            assert db.execute(text("SELECT result,outcome,outcome_details FROM routine_run")).one() == ("Retained report", None, None)
        migrate("downgrade", "e8a3c7b1d902")
        with engine.connect() as db:
            assert db.scalar(text("SELECT result FROM routine_run")) == "Retained report"
        assert "quiet_reporting" not in {col["name"] for col in inspect(engine).get_columns("routine")}
        migrate("upgrade", "head")
        with engine.connect() as db:
            assert db.scalar(text("SELECT result FROM routine_run")) == "Retained report"
    finally:
        engine.dispose()
