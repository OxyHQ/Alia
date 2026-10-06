/**
 * The egress proxy's process, in its own container (see `egress-proxy.ts` and
 * `browser-isolation.ts`). It holds no secret and mounts nothing.
 *
 *   ALIA_EGRESS_DNS          comma-separated resolver IPs (the VPC resolver the
 *                            host itself uses); asked directly, never /etc/hosts
 *   ALIA_EGRESS_DENY_CIDRS   extra IPv4 CIDRs to refuse on top of every private
 *                            and reserved range (e.g. a VPC that uses public space)
 *   PORT                     default 3128
 */
import { isIP } from 'node:net';
import { startEgressProxy } from './egress-proxy.js';
import { dnsResolver, parseCidr4 } from './network.js';

const servers = (process.env.ALIA_EGRESS_DNS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter((value) => isIP(value) !== 0);
const extraDenied = (process.env.ALIA_EGRESS_DENY_CIDRS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
  .map(parseCidr4);

let refusals = 0;
const proxy = await startEgressProxy({
  resolve: dnsResolver(servers),
  extraDenied,
  host: '0.0.0.0',
  port: Number(process.env.PORT || 3128),
  onRefused: () => {
    refusals += 1;
  },
});
console.log(JSON.stringify({ msg: 'egress proxy listening', port: proxy.port, resolvers: servers.length }));

// A count, never the destinations: which sites an agent visits is its owner's business.
const report = setInterval(() => {
  if (refusals > 0) console.log(JSON.stringify({ msg: 'egress refusals', count: refusals }));
  refusals = 0;
}, 60_000);
report.unref();

const stop = () => {
  clearInterval(report);
  void proxy.close().finally(() => process.exit(0));
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
