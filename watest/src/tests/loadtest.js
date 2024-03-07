import http from "k6/http";

export const options = {
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<300'],
  },
  vus: 10,
  duration: '10s'
}

export default function () {
  let url = "http://localhost"
  if (__ENV.EDGE_URL) {
    url = __ENV.EDGE_URL 
  };
  http.batch(__ENV.TEST_APPS.split(",").map((i) => ["GET", url, null, { headers: {"Host": i }}]));
}

