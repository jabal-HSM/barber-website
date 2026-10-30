import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://ajvswfsslwwlpsbtoccz.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_w2Iw9YFwaEAEXI1bQObFcw_qQt11-ct';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
