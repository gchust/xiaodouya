import { isIP } from 'node:net';
import type { ClientIpConfig } from './config';
import { isPrivateAddress } from './storage';

/** 把 IPv6 地址展开成 8 段，取前 4 段。家庭宽带通常分到整个 /64，只看完整地址等于没有限流。 */
function ipv6Network(address: string): string {
  const [head = '', tail] = address.split('%')[0]!.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const zeros = Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0');
  const groups = tail === undefined ? left : [...left, ...zeros, ...right];
  return `${groups
    .slice(0, 4)
    .map((g) => g.toLowerCase().replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

/**
 * 按配置从请求头取客户端地址，取不到可信的值就返回 null。
 *
 * 内网地址也算取不到：那说明这一段是代理自己，不是客户端。如果继续用它当限流的键，
 * 所有人会挤进同一个计数，一个人注册就挡住了全部用户。
 */
export function clientIpFrom(
  header: (name: string) => string | undefined,
  config: ClientIpConfig,
): string | null {
  const raw = header(config.header);
  if (!raw) return null;
  const parts = raw.split(',').map((p) => p.trim());
  const candidate = config.position === 'first' ? parts[0] : parts[parts.length - 1];
  if (!candidate || isIP(candidate) === 0 || isPrivateAddress(candidate)) return null;
  return isIP(candidate) === 6 && !candidate.toLowerCase().startsWith('::ffff:')
    ? ipv6Network(candidate)
    : candidate;
}
