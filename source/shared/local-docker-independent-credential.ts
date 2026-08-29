/** Synthetic token for independent local-docker; not a Cursor cloud credential. */
export const LOCAL_DOCKER_INDEPENDENT_ACCESS_TOKEN = "local-docker-independent";

export function isLocalDockerIndependentAccessToken(token: string | null | undefined): boolean {
  return token === LOCAL_DOCKER_INDEPENDENT_ACCESS_TOKEN;
}
