export const onRequest: PagesFunction<{ API: Fetcher }> = ({
  request,
  env,
}) => {
  const headers = new Headers(request.headers);
  for (const name of [
    "X-User-Id",
    "X-Tenant-Id",
    "X-Internal-Identity",
    "X-Forwarded-Host",
    "X-Forwarded-Proto",
  ])
    headers.delete(name);
  return env.API.fetch(new Request(request, { headers, redirect: "manual" }));
};
