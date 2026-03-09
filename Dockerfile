FROM quay.io/qasimtech/mega-md:latest

WORKDIR /root/mega-mdx

RUN git clone https://github.com/GlobalTechInfo/MEGA-MDX . && \
    npm install --legacy-peer-deps && \
    npm run build

EXPOSE 5000

CMD ["npm", "run", "start:optimized"]
