\set migration_password `echo "$MIGRATION_DATABASE_PASSWORD"`
\set application_password `echo "$DATABASE_PASSWORD"`

SELECT format('CREATE ROLE vibe_invest_migration LOGIN PASSWORD %L', :'migration_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'vibe_invest_migration') \gexec

SELECT format('CREATE ROLE vibe_invest_app LOGIN PASSWORD %L', :'application_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'vibe_invest_app') \gexec

ALTER DATABASE vibe_invest OWNER TO vibe_invest_migration;
ALTER SCHEMA public OWNER TO vibe_invest_migration;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE TEMPORARY ON DATABASE vibe_invest FROM PUBLIC;
GRANT CONNECT ON DATABASE vibe_invest TO vibe_invest_app;
GRANT USAGE ON SCHEMA public TO vibe_invest_app;
