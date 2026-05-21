import { Logger } from "tslog";
import { appendFileSync } from "fs";
const logOptions = {
    type: "pretty",
    name: "Crawler",
    prettyLogTemplate: "{{name}} {{logLevelName}} ",
    minLevel: 3,
};

export const getLogger = (name, file) => {
    logOptions.name = name;
    const logger = new Logger(logOptions);
    logger.attachTransport((logObj) => {
		try{
			appendFileSync(file, JSON.stringify(logObj) + "\n");
		}catch(e){
			console.log(e);
		}
    });
    return logger;
}
export default new Logger(logOptions);
