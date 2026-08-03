export async function resolveClientForInvoice({ supabase, userId, name }) {
  const { data: clientId, error } = await supabase.rpc('resolve_or_create_client', {
    p_user_id: userId,
    p_name: name,
  })
  if (error) throw error
  if (!clientId) throw new Error('Client resolution returned no client ID')
  return clientId
}
