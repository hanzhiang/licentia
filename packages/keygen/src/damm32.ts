/**
 * 广义 Damm 校验(q=31, 素数域).
 * 准群运算: acc := (v - acc) mod q, 满足完全反对称性(x∘x=0, 行列均为置换).
 * 性质: 检出全部单字符替换错误与相邻转置(见 spec 的性质测试).
 */
const Q = 31;

export function dammProcess(values: number[]): number {
  let acc = 0;
  for (const v of values) {
    if (!Number.isInteger(v) || v < 0 || v >= Q) {
      throw new RangeError(`symbol out of range: ${v}`);
    }
    acc = (((v - acc) % Q) + Q) % Q;
  }
  return acc;
}

/** 校验位取值: 使 full = [...body, check] 处理结果为 0 */
export function computeCheckValue(bodyValues: number[]): number {
  return dammProcess(bodyValues);
}

export function dammVerify(values: number[]): boolean {
  return dammProcess(values) === 0;
}
