import axios, { AxiosInstance, InternalAxiosRequestConfig, AxiosResponse, AxiosError } from 'axios';
import { useNaiveDiscreteApi } from '@/hooks';
import { useUserStore } from '@/store';

// 创建 Axios 实例
const request: AxiosInstance = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL, // 从环境变量获取基础地址
  timeout: 20000, // 超时时间 20s
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
  },
});

// 请求拦截器：添加 Token、处理请求参数
request.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    // 添加时间戳
    config.params = {
      ...config.params,
      timestamp: Date.now(),
    };
    // 添加用户信息
    const userStore = useUserStore();
    if (userStore.isAuthenticated) {
      // 添加 Token 和 userid
      const cookieParams = `cookie=token=${encodeURIComponent(userStore.token || '')};userid=${encodeURIComponent(userStore.userid || '')}`;
      config.url += config.url?.includes('?') ? `&${cookieParams}` : `?${cookieParams}`;
    }
    return config;
  },
  (error: AxiosError) => {
    // 请求错误处理
    const { message } = useNaiveDiscreteApi();
    message.error('请求参数错误');
    return Promise.reject(error);
  },
);

// 响应拦截器：处理响应数据、统一错误提示
request.interceptors.response.use(
  (response: AxiosResponse<any>) => {
    return response.data;
  },
  (error: AxiosError) => {
    const { message } = useNaiveDiscreteApi();
    // HTTP 状态码错误处理
    if (error.response) {
      const userStore = useUserStore();
      const status = error.response.status;
      switch (status) {
        case 401:
          // 未授权：清除 Token 并跳转到登录页
          userStore.clearUserInfo();
          message.error('登录已过期，请重新登录');
          break;
        case 403:
          message.error('没有权限访问');
          break;
        case 404:
          message.error('接口不存在');
          break;
        case 500:
          message.error('服务器内部错误');
          break;
        default:
          message.error(`请求失败（${status}）`);
      }
    } else if (error.request) {
      // 无响应（如网络错误）
      message.error('网络异常，请检查网络连接');
    }
    return Promise.reject(error);
  },
);

// 封装常用请求方法
export const api = {
  get<T = any>(url: string, params?: any, config?: InternalAxiosRequestConfig): Promise<T> {
    return request.get(url, { params, ...config });
  },

  post<T = any>(url: string, data?: any, config?: InternalAxiosRequestConfig): Promise<T> {
    return request.post(url, data, config);
  },

  put<T = any>(url: string, data?: any, config?: InternalAxiosRequestConfig): Promise<T> {
    return request.put(url, data, config);
  },

  delete<T = any>(url: string, params?: any, config?: InternalAxiosRequestConfig): Promise<T> {
    return request.delete(url, { params, ...config });
  },
};

export default request;
