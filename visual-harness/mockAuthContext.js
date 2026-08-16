export function useAuth() {
  return {
    session: { user: { id: 'visual-user', email: 'farhan@example.com' } },
    user: { id: 'visual-user', email: 'farhan@example.com' },
    loading: false,
    signOut: async () => {},
  }
}
