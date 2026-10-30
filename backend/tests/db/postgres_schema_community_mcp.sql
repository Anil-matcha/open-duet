CREATE TABLE community_mcp_connection (
	id VARCHAR(36) NOT NULL,
	owner_id VARCHAR NOT NULL,
	slug VARCHAR(64) NOT NULL,
	section VARCHAR(16) NOT NULL,
	manifest JSON NOT NULL,
	manifest_digest VARCHAR(64) NOT NULL,
	revision INTEGER DEFAULT '1' NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	PRIMARY KEY (id),
	CONSTRAINT uq_community_mcp_owner_slug UNIQUE (owner_id, slug)
);

CREATE INDEX ix_community_mcp_connection_owner ON community_mcp_connection (owner_id);

CREATE TABLE community_mcp_tool_grant (
	agent_id BIGINT NOT NULL,
	connection_id VARCHAR(36) NOT NULL,
	tool_name VARCHAR(200) NOT NULL,
	schema_digest VARCHAR(64) NOT NULL,
	description TEXT DEFAULT '' NOT NULL,
	input_schema JSON NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	PRIMARY KEY (agent_id, connection_id, tool_name),
	FOREIGN KEY(agent_id) REFERENCES agent (id) ON DELETE CASCADE,
	FOREIGN KEY(connection_id) REFERENCES community_mcp_connection (id) ON DELETE CASCADE
);

CREATE INDEX ix_community_mcp_tool_connection ON community_mcp_tool_grant (connection_id);
