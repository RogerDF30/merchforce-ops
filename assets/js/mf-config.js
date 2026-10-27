/* Merchforce — where the console and order page find the backend.
   The anon key is public by design: every browser needs it, and the database's
   row-level security and function checks decide what it can reach. */
var MF_CONFIG = {
  SUPABASE_URL: 'https://kbdrwnpvkrpekhsyuhod.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtiZHJ3bnB2a3JwZWtoc3l1aG9kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMxMDI3OTgsImV4cCI6MjEwODY3ODc5OH0.DkdrRW1XqKuJD7Yr1FZafXM3mIIHuHb5-n1ThM7Wmhw',
  BASE_DOMAIN: 'merchforce.io'
};
