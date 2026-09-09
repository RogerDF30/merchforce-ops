-- The API must NOT connect as a superuser or as the table owner.
--
-- Postgres lets a superuser bypass row-level security unconditionally, and the
-- owner bypasses it unless FORCE is set. The previous migration sets FORCE, but
-- that alone still leaves a superuser connection seeing every tenant's rows --
-- which makes the policies look present and do nothing. This role is the other
-- half: migrations run as the owner, the application runs as merchforce_app,
-- and only the latter is subject to the policies.
--
-- The dev password below is for docker-compose only. In production (Neon) the
-- role is created once with a real secret and DATABASE_URL points at it; the
-- owner credential is used only to run migrations.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'merchforce_app') THEN
    CREATE ROLE merchforce_app LOGIN PASSWORD 'merchforce_app_dev';
  END IF;
END
$$;

-- Explicit and idempotent: even if the role already existed with wider rights,
-- it ends up with none of them.
ALTER ROLE merchforce_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;

GRANT CONNECT ON DATABASE merchforce TO merchforce_app;
GRANT USAGE ON SCHEMA public TO merchforce_app;

-- DML only. No DDL: the application cannot drop a policy it dislikes.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO merchforce_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO merchforce_app;

-- Tables created by later migrations get the same treatment automatically.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO merchforce_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO merchforce_app;

-- _prisma_migrations is the owner's bookkeeping; the app has no business in it.
REVOKE ALL ON TABLE "_prisma_migrations" FROM merchforce_app;
