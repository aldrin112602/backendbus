
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.');
  process.exit(1);
}

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const isConfirmed = process.argv.includes('--confirm');

async function getAllAuthUsers() {
  const allUsers = [];
  let page = 1;
  const perPage = 1000;

  while (true) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;

    allUsers.push(...data.users);

    if (data.users.length < perPage) break; 
    page++;
  }

  return allUsers;
}

async function getAllPublicUserIds() {
  const ids = new Set();
  let from = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('id')
      .range(from, from + pageSize - 1);

    if (error) throw error;
    if (!data || data.length === 0) break;

    data.forEach((row) => ids.add(row.id));

    if (data.length < pageSize) break;
    from += pageSize;
  }

  return ids;
}

async function main() {
  console.log(isConfirmed ? '⚠️  RUNNING IN LIVE MODE — accounts WILL be deleted.' : '🔍 Running in DRY RUN mode (nothing will be deleted).');
  console.log('Fetching auth.users ...');
  const authUsers = await getAllAuthUsers();
  console.log(`Found ${authUsers.length} total auth users.`);

  console.log('Fetching public.users ids ...');
  const publicIds = await getAllPublicUserIds();
  console.log(`Found ${publicIds.size} total public.users rows.`);

  const orphaned = authUsers.filter((u) => !publicIds.has(u.id));

  if (orphaned.length === 0) {
    console.log('✅ No orphaned auth users found. Nothing to clean up.');
    return;
  }

  console.log(`\n🧹 Found ${orphaned.length} orphaned auth user(s):\n`);
  orphaned.forEach((u) => {
    console.log(`  - ${u.email || '(no email)'}  |  id: ${u.id}  |  created_at: ${u.created_at}`);
  });

  if (!isConfirmed) {
    console.log('\nThis was a DRY RUN. No accounts were deleted.');
    console.log('Review the list above carefully, then re-run with --confirm to actually delete them:');
    console.log('\n  node cleanup-orphaned-auth-users.js --confirm\n');
    return;
  }

  console.log('\nDeleting orphaned accounts...\n');
  let successCount = 0;
  let failCount = 0;

  for (const u of orphaned) {
    try {
      const { error } = await supabaseAdmin.auth.admin.deleteUser(u.id);
      if (error) throw error;
      console.log(`  ✅ Deleted: ${u.email || u.id}`);
      successCount++;
    } catch (err) {
      console.error(`  ❌ Failed to delete ${u.email || u.id}: ${err.message || err}`);
      failCount++;
    }
  }

  console.log(`\nDone. Deleted: ${successCount}, Failed: ${failCount}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});