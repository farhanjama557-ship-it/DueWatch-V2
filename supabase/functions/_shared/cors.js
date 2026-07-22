// Standard CORS headers for Edge Functions invoked directly from the
// browser (via supabase.functions.invoke). A POST with a custom
// Authorization header + JSON body is a non-"simple" request, so the
// browser sends an OPTIONS preflight first — without these headers on
// every response (including errors), the browser blocks the request
// before it's ever sent, surfacing as a generic client-side fetch failure
// rather than a real HTTP response.
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
