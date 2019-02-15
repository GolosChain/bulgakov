# GATE-SERVICE

**GATE-SERVICE** является микросервисом обмена данными между фронтендом и микросервисами [golos.io](https://golos.io).  
Также известен как фронтенд-гейт. Использует веб-сокеты с JSON-RPC для общения с клиентами.

### Основное

Микросервис пробрасывает данные между клиентами и микросервисами, используя роутинг по трем поинтам:

-   Идентификатор канала - определяется на этапе подключения пользователя.  
    Гарантирует что данные поступят конкретному получателю.
-   Имя пользователя - идентификатор пользователя, определяется автоматически.  
    Гарантирует что пользователю будут доступны только предназначенные ему данные.
    Возможен анонимный доступ для некоторых строго определенных методов.
-   Идентификатор запроса - определяется идентификатором JSON-RPC.  
    Гарантирует порядок и идентификацию ответов.

Данные внутри формируются в особом формате и переправляются дальше:

```javascript
{
    _frontendGate, // флаг формата фронтенд-гейта
            auth: {
                user, // имя пользователя
                roles, // массив ролей
            },
            routing: {
                requestId, // id запроса (если это JSON-RPC)
                channelId, // id канала (WSS)
            },
            meta: {
                clientRequestIp, // ip клиента
            },
            params, // объект параметров запроса
}
```

Пользователь обратно получает данные в JSON-RPC формате - это может быть как ответ целевого сервиса,
так и ответ с ошибкой на уровне гейта, в случае возникновения оной.

### Роутинг запросов клиента

Роутинг и валидация параметров производится на стороне FACADE-SERVICE, гейт занимается лишь переправкой входящих сообщений и более низкоуровневыми вещами.
Также гейт занимается авторизацией, о чем детальнее описано ниже.

### Авторизация

При подключении сервер сам присылает секрет на подпись в случае, если необходима авторизация при помощи сообщения в веб-сокете.

Далее необходимо отправить на сервер запрос с JSON-RPC методом `auth.authorize` и тремя параметрами - `user`, `secret` и `sign`.
`user` должен содержать имя пользователя, `sign` - сгенерированную подпись, а `secret` должен содержать объект буфера, который был получен из секрета.  
В случае успеха текущее подключение будет закреплено за указанным пользователем.

_При этом приватный ключ не передается по сети, обеспечивая безопасность авторизации._

### Детальнее об API

##### Описание API инфрастуктуры

Описание API общения с инфраструктурой содержится в документации FACADE-SERVICE т.к. именно он отвечает за роутинг.

Список методов, доступ которым предоставляется анонимно:

-   registration.getState
-   registration.firstStep
-   registration.verify
-   registration.toBlockChain
-   registration.changePhone
-   registration.resendSmsCode
-   registration.subscribeOnSmsGet
-   rates.getActual
-   rates.getHistorical
-   rates.getHistoricalMulti
-   content.getComments
-   content.getPost
-   content.getFeed
-   content.getProfile

##### Описание API самого микросервиса

Доступное клиентам извне

```
 'auth.generateSecret':   // Получить секрет авторизации для подписи
     <empty>  // Без параметров

 <- result:               // Варианты ответа
     (success):           // В случае успеха
         secret <string>  // Секрет авторизации

 <- error:                // Варианты ошибок
     <shared>             // Нет уникальных ошибок

 'auth.authorize':                    // Авторизоваться
     user <string>        // Имя пользователя
     sign <sign>          // Подпись пользователя
     secret <object>          // Буфер секрета

 <- result:              // Варианты ответа
     (success):          // В случае успеха
         status <'OK'>   // Прошло успешно

 <- error:
     1102   // Доступ запрещен, не валидный формат данных авторизации
     1103   // Доступ запрещен, блокчейн отверг авторизацию

 <shared>:

 <- error:  // Варианты ошибок
     1101   // Доступ запрещен, запрашиваемый метод не входит в разрешенный список
     1104   // Ошибка передачи данных микросервису фасаду, вероятно проблема со связью
```

Доступное внутренним микросервисам

```
 transfer:               // Отправить клиенту JSON-RPC нотификацию с данными
     channelId <string>  // Идентификатор канала
     method <string>     // Имя JSON-RPC метода
     error <Object>      // Объект ошибки (нет если result)
     result <Object>     // Объект результата (нет если error)

 <- result:              // Варианты ответа
     (success):          // В случае успеха
        status <'OK'>    // Прошло успешно

 <- error:  // Варианты ошибок
     1105   // Клиент не был найден, может возникать если соединение с ним было отключено
     1106   // Фатальная ошибка, ошибка в коде или непредвиденные критические неполадки с каналом

```

### Переменные окружения

Возможные переменные окружения `ENV`:

-   `GLS_FACADE_CONNECT` _(обязательно)_ - адрес подключения к микросервису фасаду.

-   `GLS_AUTH_CONNECT` _(обязательно)_ - адрес подключения к микросервису авторизации

-   `GLS_FRONTEND_GATE_HOST` _(обязательно)_ - адрес, который будет использован для входящих веб-сокет подключений клиентов.  
    Дефолтное значение при запуске без докера - `0.0.0.0`

-   `GLS_FRONTEND_GATE_PORT` _(обязательно)_ - адрес порта, который будет использован для входящих веб-сокет подключений клиентов.  
    Дефолтное значение при запуске без докера - `8080`, пересекается с `GLS_GATE_PORT`
-   `GLS_CONNECTOR_HOST` _(обязательно)_ - адрес, который будет использован для входящих подключений связи микросервисов.  
    Дефолтное значение при запуске без докера - `0.0.0.0`
-   `GLS_CONNECTOR_PORT` _(обязательно)_ - адрес порта, который будет использован для входящих подключений связи микросервисов.  
    Дефолтное значение при запуске без докера - `8080`, пересекается с `GLS_FRONTEND_GATE_PORT`
-   `GLS_METRICS_HOST` _(обязательно)_ - адрес хоста для метрик StatsD.  
    Дефолтное значение при запуске без докера - `127.0.0.1`
-   `GLS_METRICS_PORT` _(обязательно)_ - адрес порта для метрик StatsD.  
    Дефолтное значение при запуске без докера - `8125`
-   `GLS_MONGO_CONNECT` - строка подключения к базе MongoDB.  
    Дефолтное значение - `mongodb://mongo/admin`
-   `GLS_DAY_START` - время начала нового дня в часах относительно UTC.
    Дефолтное значение - `3` (день начинается в 00:00 по Москве).

-   `GLS_FRONTEND_GATE_TIMEOUT_FOR_CLIENT` - время, через которе клиент, подключенный по веб-сокету, будет отключен если он не отвечает на пинг запросы или от него не приходят новые входящие запросы.  
    Дефолтное значение - `60000` (1 минута)

### Запуск

Для запуска достаточно вызвать команду `docker-compose up` в корне проекта, предварительно указав необходимые `ENV` переменные.
