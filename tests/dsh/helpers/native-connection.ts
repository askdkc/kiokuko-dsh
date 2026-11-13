/** Mount the actual connection service with the authentication API it exposes. */
export async function mountNativeConnection(ctx: any, connection: any, name: string) {
  return ctx.plugin({ name, async apply(owner: any) {
    if (typeof connection.ConnectionAuthentication === 'function') {
      new connection.ConnectionAuthentication(owner)
      await owner.plugin({ name: `${name}-host`, inject: ['connection.authentication'], apply(scope: any) {
        new connection.HostConnectionService(scope, [])
      } })
    } else {
      new connection.HostConnectionService(owner, [], { isAuthenticated: () => true })
    }
  } })
}
