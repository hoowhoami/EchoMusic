import { isArray, isObject } from 'lodash-es';

// 定义带有索引签名的树节点类型
interface IndexedTreeNode {
  [key: string]: any; // 允许使用字符串索引访问任意属性
  children?: IndexedTreeNode[];
}

/**
 * 查找树节点（修复索引签名错误）
 */
export function findTreeNodeByField(
  tree: IndexedTreeNode | IndexedTreeNode[],
  field: string,
  value: any | ((val: any) => boolean),
  childrenKey: string = 'children',
): IndexedTreeNode | null {
  const nodes = isArray(tree) ? tree : [tree];

  for (const node of nodes) {
    if (!isObject(node)) continue;

    // 现在可以安全地用字符串 field 访问节点属性
    const isMatch = typeof value === 'function' ? value(node[field]) : node[field] === value;

    if (isMatch) {
      return node;
    }

    const children = node[childrenKey];
    if (isArray(children) && children.length > 0) {
      const found = findTreeNodeByField(children, field, value, childrenKey);
      if (found) return found;
    }
  }

  return null;
}
