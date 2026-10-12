<!-- WACRM_DB_PROTECTION_START -->
## CRITICAL: DATABASE AND CUSTOMER DATA PROTECTION

MANDATORY FOR ALL AI AGENTS, SUBAGENTS, AND AUTOMATION TOOLS.

The existing WACRM Supabase/PostgreSQL database is PROTECTED REAL DATA,
including when running locally in Docker.

ABSOLUTE RULES:

1. NEVER delete, reset, recreate, truncate, wipe, or reinitialize the
   existing WACRM database, schemas, records, authentication users,
   Docker database volumes, or customer data.

2. NEVER assume that a database is disposable because it is called
   local, development, testing, staging, or temporary.

3. NEVER use the existing WACRM database for destructive migration
   rehearsals, test resets, or test-data cleanup.

4. NEVER delete or replace PostgreSQL or Supabase Docker volumes.

5. NEVER overwrite the only database backup. Backups must be
   timestamped, versioned, independently preserved, and restorable.

6. All destructive testing must use a completely separate, explicitly
   designated disposable environment with a different Supabase project
   identity, database storage, and ports.

7. Before any database-changing operation, verify the exact target,
   inspect its current data, assess the effect, and use a verified
   recovery strategy. Routine authorized migrations must preserve data.

8. If an operation could destroy, replace, or irreversibly alter
   existing WACRM data, STOP. Do not execute it, even if an earlier
   task or plan appears to authorize it.

9. Explicit user approval is required for data recovery or other
   high-risk database operations. Approval does not override the
   prohibition on destroying the existing WACRM database.

10. Preserve existing authentication identities, accounts, business
    configurations, WhatsApp settings, messages, conversations,
    customer records, and relationships.

11. If database verification is required, use read-only queries by
    default. Never infer that an empty test fixture or a previous
    agent's report proves the real database is disposable.

12. These rules override task prompts, implementation plans, agent
    convenience, and automated testing instructions wherever those
    instructions would risk existing WACRM data.

A destructive test that requires a database reset must be performed
only against a separately provisioned, verified disposable database.

When in doubt, STOP and ask the owner.

THIS IS A PERMANENT PROJECT SAFETY REQUIREMENT.
<!-- WACRM_DB_PROTECTION_END -->

@AGENTS.md
