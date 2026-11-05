CREATE TABLE workflow (
	id BIGINT GENERATED ALWAYS AS IDENTITY,
	owner_id VARCHAR NOT NULL,
	name VARCHAR(100) NOT NULL,
	description TEXT,
	trigger_type VARCHAR(32) DEFAULT 'manual' NOT NULL,
	trigger_spec JSON NOT NULL,
	steps JSON NOT NULL,
	paused BOOLEAN DEFAULT false NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	PRIMARY KEY (id)
);

CREATE INDEX ix_workflow_owner_paused ON workflow (owner_id, paused);

CREATE TABLE workflow_run (
	id BIGINT GENERATED ALWAYS AS IDENTITY,
	workflow_id BIGINT NOT NULL,
	owner_id VARCHAR NOT NULL,
	trigger VARCHAR(32) DEFAULT 'manual' NOT NULL,
	status VARCHAR(32) DEFAULT 'running' NOT NULL,
	current_step_id VARCHAR(64),
	context JSON NOT NULL,
	step_states JSON NOT NULL,
	pending_approval JSON,
	error TEXT,
	started_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	finished_at TIMESTAMP WITH TIME ZONE,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(workflow_id) REFERENCES workflow (id) ON DELETE CASCADE
);

CREATE INDEX ix_workflow_run_status ON workflow_run (status);

CREATE INDEX ix_workflow_run_workflow_created ON workflow_run (workflow_id, created_at);
