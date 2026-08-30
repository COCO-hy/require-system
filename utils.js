// 共享工具函数

/**
 * 规范化 Gitee 仓库地址为 owner/repo 格式
 * 支持:
 *   - https://gitee.com/owner/repo
 *   - https://gitee.com/owner/repo.git
 *   - http://gitee.com/owner/repo
 *   - git@gitee.com:owner/repo.git  (SSH 形式)
 *   - owner/repo
 *   - owner/repo.git
 * 空值返回空字符串
 */
function normalizeGiteeRepo(value) {
  if (!value) return '';
  let repo = String(value).trim();
  if (!repo) return '';

  // SSH 形式: git@gitee.com:owner/repo.git
  if (/^git@[^:]+:[^/]+\//.test(repo)) {
    repo = repo.slice(repo.indexOf(':') + 1);
  } else if (/^https?:\/\//i.test(repo)) {
    // URL 形式: 取 pathname 部分
    try {
      repo = new URL(repo).pathname;
    } catch (e) {
      // 解析失败则按原样继续处理
    }
  }

  // 去掉首尾斜杠和可选 .git 后缀
  repo = repo.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').trim();
  return repo;
}

module.exports = { normalizeGiteeRepo };
