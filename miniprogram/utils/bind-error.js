// 设备绑定错误 -> 友好提示文案（Task C）
// cdmsRequest 的错误对象结构（见 utils/api.js request）：
//   error.statusCode / error.code / error.response（服务端 body）/ error.message('HTTP <statusCode>')
// 后端同事已把 IoT"设备已被其他患者绑定"的 400 映射为 cdms 409 业务错误（message 含"已被"），
// 小程序侧在此统一识别并给出可读提示。

const ALREADY_BOUND_MESSAGE = "该设备已被其他患者绑定，无法绑定";

// 收集错误对象中的可读文本（兼容 message / response.message / response.msg / detail 等字段）
function collectErrorText(error) {
  if (!error) return "";
  const parts = [];
  const push = (value) => {
    if (value == null) return;
    const text = typeof value === "string" ? value : String(value);
    if (text && parts.indexOf(text) === -1) parts.push(text);
  };
  push(error.message);
  push(error.msg);
  push(error.code);
  if (error.response) {
    push(error.response.message);
    push(error.response.msg);
    push(error.response.error);
    if (typeof error.response === "string") push(error.response);
  }
  push(error.detail);
  return parts.join(" ").trim();
}

// 返回友好提示文案；无法识别的错误返回空字符串（由调用方走默认错误提示）。
function friendlyBindErrorMessage(error) {
  if (!error) return "";
  const statusCode = error.statusCode || (error.response && error.response.statusCode) || 0;
  if (statusCode === 409) return ALREADY_BOUND_MESSAGE;
  const text = collectErrorText(error);
  if (text && text.indexOf("已被") !== -1) return ALREADY_BOUND_MESSAGE;
  return "";
}

module.exports = { friendlyBindErrorMessage, collectErrorText, ALREADY_BOUND_MESSAGE };
