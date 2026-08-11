-- oxy:deploy-phase=pre
CREATE UNIQUE INDEX "mcp_servers_oxy_user_name_key" ON "mcp_servers" USING btree ("oxy_user_id","name");