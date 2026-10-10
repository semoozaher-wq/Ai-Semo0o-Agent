# Repository deletions required

هذه ليست ملفات جديدة أو معدلة ولذلك لا تُنسخ داخل ZIP الملفات المعدلة، لكنها يجب أن تُحذف من Git في نفس commit:

```text
gitignore
اتجاهل هذا الملف القديم؛ الاسم الصحيح هو .gitignore.

dist/**
مخرجات Expo Web مولدة. يتم إنتاجها عبر npm run build ويجب ألا تُتبع في source repository.
```

الأمر المقترح عند تطبيق التغييرات:

```bash
git rm -r --cached dist
git rm gitignore
# اترك dist محليًا إن احتجت المعاينة؛ .gitignore سيمنع إعادة إضافته.
git add .gitignore
```
