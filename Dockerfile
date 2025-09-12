# استخدام Node.js LTS
FROM node:18-alpine

# إنشاء مجلد التطبيق
WORKDIR /app

# نسخ ملفات package أولاً للاستفادة من Docker layer caching
COPY package*.json ./

# تثبيت التبعيات
RUN npm ci --only=production

# نسخ باقي ملفات التطبيق
COPY . .

# إنشاء مجلد البيانات
RUN mkdir -p /app/data

# إنشاء مستخدم غير جذر للأمان
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nodeuser -u 1001

# إعطاء الصلاحيات للمستخدم
RUN chown -R nodeuser:nodejs /app

# التبديل للمستخدم الجديد
USER nodeuser

# كشف المنفذ
EXPOSE 3001

# فحص الصحة
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"

# تشغيل التطبيق
CMD ["node", "index.js"]
