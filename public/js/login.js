/* ═══════════════════════════════════════════════════════════
   用户登录页面 — 交互逻辑
   功能：表单验证 / Loading 状态 / 记住密码
   ═══════════════════════════════════════════════════════════ */

(function() {
  'use strict';

  // ── DOM refs ──
  const form = document.getElementById('loginForm');
  const usernameInput = document.getElementById('username');
  const passwordInput = document.getElementById('password');
  const rememberCheck = document.getElementById('rememberMe');
  const loginBtn = document.getElementById('loginBtn');
  const btnText = document.querySelector('.btn-text');
  const spinner = document.querySelector('.spinner');
  const usernameError = document.getElementById('usernameError');
  const passwordError = document.getElementById('passwordError');
  const loginSuccess = document.querySelector('.login-success');

  // ── Helpers ──

  /** 显示字段错误 */
  function showFieldError(input, errorEl, message) {
    input.classList.add('error');
    errorEl.textContent = message;
    errorEl.classList.add('visible');
  }

  /** 清除字段错误 */
  function clearFieldError(input, errorEl) {
    input.classList.remove('error');
    errorEl.textContent = '';
    errorEl.classList.remove('visible');
  }

  /** 设置按钮 loading 状态 */
  function setLoading(loading) {
    if (loading) {
      loginBtn.disabled = true;
      loginBtn.classList.add('loading');
      btnText.textContent = '登录中...';
    } else {
      loginBtn.disabled = false;
      loginBtn.classList.remove('loading');
      btnText.textContent = '登 录';
    }
  }

  // ── 表单验证 ──

  /** 验证整个表单，返回是否通过 */
  function validateForm() {
    let isValid = true;

    // 验证用户名
    const username = usernameInput.value.trim();
    if (!username) {
      showFieldError(usernameInput, usernameError, '请输入用户名');
      isValid = false;
    } else {
      clearFieldError(usernameInput, usernameError);
    }

    // 验证密码
    const password = passwordInput.value.trim();
    if (!password) {
      showFieldError(passwordInput, passwordError, '请输入密码');
      isValid = false;
    } else {
      clearFieldError(passwordInput, passwordError);
    }

    return isValid;
  }

  // ── 输入时清除错误（实时反馈） ──
  usernameInput.addEventListener('input', function() {
    if (this.value.trim()) {
      clearFieldError(this, usernameError);
    }
  });

  passwordInput.addEventListener('input', function() {
    if (this.value.trim()) {
      clearFieldError(this, passwordError);
    }
  });

  // ── 记住密码 ──

  /** 加载保存的用户名 */
  function loadRememberedUser() {
    try {
      const saved = localStorage.getItem('login_remembered_user');
      if (saved) {
        usernameInput.value = saved;
        rememberCheck.checked = true;
      }
    } catch (e) {
      // localStorage 不可用时静默失败
    }
  }

  /** 保存或清除记住的用户名 */
  function saveRememberedUser(remember, username) {
    try {
      if (remember && username) {
        localStorage.setItem('login_remembered_user', username);
      } else {
        localStorage.removeItem('login_remembered_user');
      }
    } catch (e) {
      // localStorage 不可用时静默失败
    }
  }

  // ── 模拟登录请求 ──

  /** 模拟登录 API 调用 */
  function mockLogin(username, password) {
    return new Promise((resolve, reject) => {
      // 模拟网络延迟 1.5~2s
      const delay = 1500 + Math.random() * 500;
      setTimeout(() => {
        // 模拟验证：admin/admin123 成功，其余随机成功/失败
        if (username === 'admin' && password === 'admin123') {
          resolve({ success: true, message: '登录成功', user: { name: '管理员' } });
        } else if (username && password) {
          // 其他合法凭据 80% 成功
          if (Math.random() < 0.8) {
            resolve({ success: true, message: '登录成功', user: { name: username } });
          } else {
            reject(new Error('用户名或密码错误'));
          }
        } else {
          reject(new Error('请填写完整信息'));
        }
      }, delay);
    });
  }

  // ── 表单提交 ──

  form.addEventListener('submit', async function(e) {
    e.preventDefault();

    // 防止重复提交
    if (loginBtn.disabled) return;

    // 1. 验证
    if (!validateForm()) return;

    const username = usernameInput.value.trim();
    const password = passwordInput.value.trim();

    // 2. Loading 状态
    setLoading(true);

    try {
      // 3. 发送请求（模拟）
      const result = await mockLogin(username, password);

      // 4. 登录成功
      setLoading(false);
      saveRememberedUser(rememberCheck.checked, username);

      // 显示成功界面
      form.style.display = 'none';
      loginSuccess.classList.add('show');
      loginSuccess.querySelector('h3').textContent = `欢迎回来，${result.user.name}！`;
      loginSuccess.querySelector('p').textContent = '正在跳转到系统主页...';

      // 5. 1.5 秒后跳转（模拟）
      setTimeout(() => {
        window.location.href = '/';
      }, 1500);

    } catch (err) {
      // 6. 登录失败
      setLoading(false);
      showFieldError(passwordInput, passwordError, err.message || '登录失败，请重试');
      passwordInput.value = '';
      passwordInput.focus();
    }
  });

  // ── 初始化 ──

  loadRememberedUser();

  // 如果记住的用户名存在，自动聚焦到密码框
  if (usernameInput.value) {
    passwordInput.focus();
  }

})();
