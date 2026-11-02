import { z } from 'zod';

// zod 默认会试探 new Function，CSP 不允许，试探失败在控制台留一条报错。
// 它在定义 schema 时就试探，所以这个文件要排在所有 import 的最前面。
z.config({ jitless: true });
