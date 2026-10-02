# طريقة إضافة BodyMap Pain إلى GitHub

## الطريقة الأولى: رفع المشروع لأول مرة من الكمبيوتر

بعد فك ضغط الملف، افتح Terminal داخل مجلد المشروع ونفّذ:

```bash
cd bodymap-pain
git init
git add .
git commit -m "Initial BodyMap Pain app"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/bodymap-pain.git
git push -u origin main
```

استبدل `YOUR_USERNAME` باسم حسابك على GitHub.

إذا كان المستودع موجودًا بالفعل وفيه ملفات، استخدم:

```bash
git pull origin main --allow-unrelated-histories
git push origin main
```

## الطريقة الثانية: استخدام GitHub CLI

بعد تثبيت GitHub CLI وتسجيل الدخول:

```bash
gh auth login
gh repo create bodymap-pain --public --source=. --remote=origin --push
```

## الطريقة الثالثة: الرفع من موقع GitHub

1. أنشئ مستودعًا جديدًا باسم `bodymap-pain`.
2. اضغط **Add file** ثم **Upload files**.
3. فك ضغط ملف ZIP على جهازك.
4. اسحب ملفات المشروع إلى صفحة الرفع.
5. اضغط **Commit changes**.

> لا ترفع مجلد `node_modules` إلى GitHub. يتم إنشاؤه تلقائيًا بعد تشغيل `npm install`.

## تشغيل المشروع بعد تنزيله

```bash
npm install
npx expo start
```

## تحديث المشروع بعد أي تعديل

```bash
git add .
git commit -m "Describe your change"
git push
```

## ملاحظات مهمة

- لا تضع مفاتيح API أو كلمات مرور داخل المستودع.
- لا ترفع بيانات صحية حقيقية للمستخدمين.
- راجع المحتوى الطبي مع طبيب مختص قبل النشر.
- ملف ZIP هو نسخة مشاركة، أما GitHub فهو المكان الأفضل لمتابعة التعديلات والإصدارات.
