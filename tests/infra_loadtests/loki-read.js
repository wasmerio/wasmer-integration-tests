import { URL } from 'https://jslib.k6.io/url/1.0.0/index.js';
import http from 'k6/http';
export const options = {

  vus: 1000,

  duration: '30s',

};
export default function () {
  const url = new URL('http://localhost:3100/loki/api/v1/query');
  url.searchParams.append('query', '{app="deploy-instances", app_id="da_ynYYILtXUBBn", app_version_id="dav_7nVEIot6uyEK"}');
  http.get(url.toString());
}